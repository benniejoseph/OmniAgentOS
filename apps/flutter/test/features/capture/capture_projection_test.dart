import 'dart:async';
import 'dart:typed_data';

import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/network/api_exception.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:asael/features/capture/capture_api_repository.dart';
import 'package:asael/features/capture/capture_models.dart';
import 'package:asael/features/capture/capture_outbox.dart';
import 'package:asael/features/capture/capture_projection.dart';
import 'package:dio/dio.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

import 'capture_test_support.dart';

class _Api extends ApiClient {
  _Api()
    : super(
        Dio(BaseOptions(baseUrl: 'https://capture.test')),
        Dio(),
        SecureSessionStore(const FlutterSecureStorage()),
      );
  Map<String, dynamic> response = {};
  Uint8List bytes = Uint8List.fromList([1, 2, 3]);
  final reads = <String>[],
      posts =
          <
            ({
              String path,
              Map<String, dynamic> fields,
              Map<String, dynamic>? headers,
            })
          >[];
  @override
  Future<Map<String, dynamic>> getJsonFreshCancelable(
    String path, {
    Map<String, dynamic>? query,
    Map<String, dynamic>? headers,
    required CancelToken cancelToken,
  }) async {
    reads.add(path);
    return response;
  }

  @override
  Future<Map<String, dynamic>> getJson(
    String path, {
    Map<String, dynamic>? query,
  }) async => throw StateError('Cached reads must not be used');
  @override
  Future<Map<String, dynamic>> postMultipart(
    String path, {
    required Map<String, dynamic> fields,
    Uint8List? bytes,
    String? filename,
    String? contentType,
    String fileField = 'file',
    Map<String, dynamic>? headers,
    Duration? receiveTimeout,
    NativeRequestAuthority? authority,
  }) async {
    posts.add((path: path, fields: fields, headers: headers));
    return response;
  }

  @override
  Future<Uint8List> getBytes(
    String path, {
    Map<String, dynamic>? query,
    int maximumBytes = 64 * 1024 * 1024,
  }) async {
    reads.add(path);
    return bytes;
  }
}

Map<String, dynamic> _receipt({Map<String, dynamic>? asset}) => {
  'job': {
    'id': 'job-one',
    'type': 'capture.asset.process',
    'status': 'queued',
    'progress': {'stage': 'queued'},
  },
  'asset': asset ?? captureTestAssetJson(),
  'capture': {
    'title': 'Original',
    'tags': ['source'],
    'source': 'capture:asset:asset:東京/full%2F',
  },
};
void main() {
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));
  test('extraction partial or unsupported remains distinct even when a document is indexed', () {
    for (final state in ['partial', 'unsupported', 'failed']) {
      final asset = CaptureAssetSnapshot.fromJson(
        captureTestAssetJson(
          status: 'indexed',
          extraction: state,
          documentId: 'document-one',
        ),
      );
      expect(asset.indexed, isTrue);
      expect(asset.extractionLabel, contains(state));
      expect(asset.contentIdentity, contains(captureTestHash));
    }
    expect(
      CaptureAssetSnapshot.fromJson(captureTestAssetJson(status: 'indexed'))
          .indexed,
      isFalse,
    );
  });
  test(
    'malformed original metadata cannot fabricate a healthy source or version',
    () {
      for (final replacement in [
        {'byteCount': '3'},
        {'contentSha256': 'not-a-digest'},
        {'filename': '../private.pdf'},
        {'status': 'ready'},
        {'extractionStatus': 'complete'},
        {'contentAvailable': 'true'},
      ]) {
        expect(
          () => CaptureAssetSnapshot.fromJson({
            ...captureTestAssetJson(),
            ...replacement,
          }),
          throwsFormatException,
        );
      }
    },
  );
  test('submission preserves exact original source, job, hash and owner-binding headers', () async {
    final api = _Api()..response = _receipt();
    final receipt =
        await ApiCaptureRepository(api, authorityCurrent: (_) => true).submit(
          captureTestDraft(),
          idempotencyKey: 'capture-offline-same-key',
          owner: captureTestOwner,
        );
    expect(receipt.asset!.contentSha256, captureTestHash);
    expect(receipt.source, 'capture:asset:asset:東京/full%2F');
    expect(receipt.jobId, 'job-one');
    expect(
      api.posts.single.headers!['x-omni-correlation-id'],
      'capture-offline-same-key',
    );
    expect(
      api.posts.single.headers!['x-asael-capture-owner-sha256'],
      await captureTestOwner.sha256(),
    );
  });
  test(
    'scope loss while hashing the owner cannot dispatch admitted private bytes',
    () async {
      final api = _Api()..response = _receipt();
      final owner = _DelayedOwner();
      var current = true;
      final request =
          ApiCaptureRepository(api, authorityCurrent: (_) => current).submit(
            captureTestDraft(),
            idempotencyKey: 'capture-offline-retained',
            owner: owner,
          );
      final failed = expectLater(request, throwsA(isA<ApiException>()));
      await owner.arrived.future;
      current = false;
      owner.release.complete(await captureTestOwner.sha256());
      await failed;
      expect(api.posts, isEmpty);
    },
  );
  test(
    'wrong actor, content hash or processing linkage remains unconfirmed',
    () async {
      final api = _Api();
      for (final replacement in [
        {'actorId': 'other'},
        {'ingestJobId': 'different-job'},
        {'contentSha256': List.filled(64, 'a').join()},
        {'byteCount': 2},
      ]) {
        api.response = _receipt(
          asset: {...captureTestAssetJson(), ...replacement},
        );
        await expectLater(
          ApiCaptureRepository(api, authorityCurrent: (_) => true).submit(
            captureTestDraft(),
            idempotencyKey: 'capture-offline-same',
            owner: captureTestOwner,
          ),
          throwsFormatException,
        );
      }
    },
  );
  test(
    'a shared link is submitted only as note text with no remote fetch',
    () async {
      final api = _Api()
        ..response = {
          'job': {
            'id': 'job-one',
            'type': 'knowledge.ingest',
            'status': 'queued',
          },
          'capture': {
            'title': 'Link note',
            'source': 'capture://quick-note',
            'tags': [],
          },
        };
      await ApiCaptureRepository(api, authorityCurrent: (_) => true).submit(
        const CaptureDraft(content: 'https://synthetic.invalid/private-path'),
        idempotencyKey: 'capture-offline-note',
        owner: captureTestOwner,
      );
      expect(api.posts.single.path, '/api/capture');
      expect(
        api.posts.single.fields['content'],
        'https://synthetic.invalid/private-path',
      );
      expect(api.reads, isEmpty);
    },
  );
  test(
    'fresh job reads encode the whole identity once and reject other job types',
    () async {
      const id = 'job/東京:part%2F';
      final api = _Api()
        ..response = {
          'job': {
            'id': id,
            'type': 'capture.asset.process',
            'status': 'completed',
            'result': {'documentId': 'document-one'},
          },
        };
      final value = await ApiCaptureRepository(
        api,
        authorityCurrent: (_) => true,
      ).readJob(id, owner: captureTestOwner);
      expect(value.documentId, 'document-one');
      expect(
        api.reads.single,
        '/api/operations/jobs/${Uri.encodeComponent(id)}',
      );
      api.response = {
        'job': {'id': id, 'type': 'market.backfill', 'status': 'completed'},
      };
      await expectLater(
        ApiCaptureRepository(
          api,
          authorityCurrent: (_) => true,
        ).readJob(id, owner: captureTestOwner),
        throwsFormatException,
      );
    },
  );
  test('original reads bind exact owner and verify byte count plus SHA-256 before returning bytes', () async {
    final api = _Api()..response = {'asset': captureTestAssetJson()};
    final repository = ApiCaptureRepository(api, authorityCurrent: (_) => true);
    final asset = await repository.readAsset(
      'asset:東京/full%2F',
      owner: captureTestOwner,
      cancelToken: CancelToken(),
    );
    expect(await repository.downloadOriginal(asset, owner: captureTestOwner), [
      1,
      2,
      3,
    ]);
    expect(
      api.reads.last,
      '/api/capture/assets/${Uri.encodeComponent(asset.id)}?content=1',
    );
    api.bytes = Uint8List.fromList([3, 2, 1]);
    await expectLater(
      repository.downloadOriginal(asset, owner: captureTestOwner),
      throwsFormatException,
    );
    api.response = {'asset': captureTestAssetJson(actor: 'other')};
    await expectLater(
      repository.readAsset(
        asset.id,
        owner: captureTestOwner,
        cancelToken: CancelToken(),
      ),
      throwsFormatException,
    );
  });
}

class _DelayedOwner extends CaptureOwnerBinding {
  _DelayedOwner()
    : super(
        tenantId: captureTestOwner.tenantId,
        actorId: captureTestOwner.actorId,
        canonicalUserId: captureTestOwner.canonicalUserId,
        apiOrigin: captureTestOwner.apiOrigin,
        role: captureTestOwner.role,
      );
  final arrived = Completer<void>();
  final release = Completer<String>();
  @override
  Future<String> sha256() {
    arrived.complete();
    return release.future;
  }
}
