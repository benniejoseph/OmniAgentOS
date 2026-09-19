import 'dart:typed_data';

import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:asael/features/results/results_api_repository.dart';
import 'package:dio/dio.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));

  test(
    'lists created files separately from execution and knowledge results',
    () async {
      final api = _ResultsApiClient();
      final repository = ApiResultsRepository(api);

      final snapshot = await repository.list();

      expect(api.jsonReads, contains('/api/artifacts?limit=50'));
      expect(snapshot.items, hasLength(1));
      expect(snapshot.createdFiles, hasLength(1));
      expect(snapshot.createdFiles.single.title, 'Service Cloud AI pitch');
      expect(snapshot.createdFiles.single.ready, isTrue);
      expect(snapshot.sourceErrors, isEmpty);
    },
  );

  test(
    'keeps the execution ledger usable when created files are unavailable',
    () async {
      final api = _ResultsApiClient(throwArtifacts: true);

      final snapshot = await ApiResultsRepository(api).list();

      expect(snapshot.items, hasLength(1));
      expect(snapshot.createdFiles, isEmpty);
      expect(snapshot.sourceErrors, contains('created files unavailable'));
    },
  );

  test(
    'downloads only the exact ready version and verifies its byte count',
    () async {
      final api = _ResultsApiClient();
      final repository = ApiResultsRepository(api);
      final artifact = (await repository.list()).createdFiles.single;

      final bytes = await repository.downloadGeneratedArtifact(artifact);

      expect(bytes, [80, 75, 3, 4]);
      expect(api.byteReads, [
        '/api/artifacts/${artifact.id}/content?version=3',
      ]);
      expect(api.byteLimits, [4]);
    },
  );
}

class _ResultsApiClient extends ApiClient {
  _ResultsApiClient({this.throwArtifacts = false})
    : super(Dio(), Dio(), SecureSessionStore(const FlutterSecureStorage()));

  final bool throwArtifacts;
  final jsonReads = <String>[];
  final byteReads = <String>[];
  final byteLimits = <int>[];

  @override
  Future<Map<String, dynamic>> getJson(
    String path, {
    Map<String, dynamic>? query,
  }) async {
    jsonReads.add(path);
    if (path == '/api/artifacts?limit=50') {
      if (throwArtifacts) throw StateError('offline');
      return {
        'artifacts': [
          _artifact(),
          _artifact({'id': '../invalid-authority'}),
        ],
      };
    }
    if (path == '/api/workspace-summary') {
      return {
        'summary': {
          'sources': {
            'runs': {
              'status': 'ready',
              'data': [
                {
                  'id': 'run-one',
                  'prompt': 'Create a pitch deck',
                  'status': 'completed',
                  'response': 'The file is ready.',
                },
              ],
            },
            'workflows': {'status': 'ready', 'data': <Object>[]},
            'approvals': {'status': 'ready', 'data': <Object>[]},
          },
        },
      };
    }
    if (path == '/api/evaluations') return {'runs': <Object>[]};
    throw StateError('Unexpected path $path');
  }

  @override
  Future<Uint8List> getBytes(
    String path, {
    Map<String, dynamic>? query,
    int maximumBytes = 64 * 1024 * 1024,
  }) async {
    byteReads.add(path);
    byteLimits.add(maximumBytes);
    return Uint8List.fromList([80, 75, 3, 4]);
  }
}

Map<String, dynamic> _artifact([Map<String, dynamic> overrides = const {}]) {
  final id = 'generated_artifact_${List.filled(48, 'c').join()}';
  return {
    'id': id,
    'kind': 'presentation',
    'title': 'Service Cloud AI pitch',
    'filename': 'Service Cloud AI pitch.pptx',
    'currentVersion': 3,
    'createdAt': '2026-09-19T02:00:00.000Z',
    'updatedAt': '2026-09-19T02:00:00.000Z',
    'current': {
      'version': 3,
      'status': 'ready',
      'mediaType': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'byteCount': 4,
      'queuedAt': '2026-09-19T02:00:00.000Z',
      'readyAt': '2026-09-19T02:01:00.000Z',
      'failedAt': null,
      'contentUrl': 'https://untrusted.example/private.pptx',
    },
    ...overrides,
  };
}
