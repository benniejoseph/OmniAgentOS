import 'dart:async';

import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:asael/features/meetings/meetings.dart';
import 'package:asael/features/meetings/meetings_access.dart';
import 'package:asael/features/meetings/meetings_api_repository.dart';
import 'package:asael/features/meetings/meetings_mutations.dart';
import 'package:asael/generated/native_contract.g.dart';
import 'package:dio/dio.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

import 'meetings_test_support.dart';

class _Api extends ApiClient {
  _Api()
    : super(
        Dio(BaseOptions(baseUrl: meetingOwner.apiScope)),
        Dio(),
        SecureSessionStore(const FlutterSecureStorage()),
      );
  Future<Json> Function(String)? reader;
  Future<Json> Function()? writer;
  String? path;
  Json? query, sent, headers;
  CancelToken? token;
  NativeRequestAuthority? authority;
  @override
  Future<Json> getJson(String path, {Json? query}) =>
      throw StateError('Cached reads are forbidden.');
  @override
  Future<Json> getJsonFreshCancelable(
    String path, {
    Json? query,
    Json? headers,
    required CancelToken cancelToken,
  }) {
    this.path = path;
    this.query = query;
    token = cancelToken;
    return reader!(path);
  }

  @override
  Future<Json> postJsonAuthorized(
    String path, {
    required NativeRequestAuthority authority,
    Json? data,
    Json? headers,
  }) async {
    this.path = path;
    this.authority = authority;
    sent = data;
    this.headers = headers;
    return writer == null ? {} : writer!();
  }

  @override
  Future<Json> patchJsonAuthorized(
    String path, {
    required NativeRequestAuthority authority,
    Json? data,
    Json? headers,
  }) => postJsonAuthorized(
    path,
    authority: authority,
    data: data,
    headers: headers,
  );
}

Future<Json> _detailWithMediaOutput() async {
  final value = meetingDetailJson(pending: true);
  final turnId = 'media-turn:${'e' * 64}';
  final output = <String, dynamic>{
    'schemaVersion': 1,
    'tenantId': meetingOwner.tenantId,
    'ownerActorId': meetingOwner.actorId,
    'recordingId': 'recording-1',
    'meetingId': meetingTestId,
    'mediaRevision': 1,
    'mediaRevisionId': 'recording-1:media:v1',
    'sourceAudioManifestSha256': meetingDigest,
    'transcriptionModel': 'fixture-transcription',
    'extractionModel': 'fixture-extraction',
    'languageTags': ['en-US'],
    'turns': [
      {
        'turnId': turnId,
        'segmentId': 'segment-1',
        'segmentIndex': 0,
        'sourceAudioSha256': meetingDigest,
        'startMilliseconds': 0,
        'endMilliseconds': 1000,
        'languageTag': 'en-US',
        'text': 'Review the release.',
        'speaker': {
          'label': 'Owner',
          'identity': 'known',
          'participantId': 'person-1',
          'displayName': 'Owner',
        },
      },
    ],
    'chapters': [],
    'summary': {
      'text': 'Review the release.',
      'citations': [
        {
          'turnId': turnId,
          'segmentIndex': 0,
          'startMilliseconds': 0,
          'endMilliseconds': 1000,
          'speakerLabel': 'Owner',
          'speakerParticipantId': 'person-1',
        },
      ],
    },
    'actionItems': [],
    'decisions': [],
    'warnings': [],
    'rawAudioRetention': {'mode': 'retain'},
    'processedAt': '2026-10-04T10:00:00.000Z',
  };
  final media = Map<String, dynamic>.from(
    value['linkedSources'][0]['media'] as Map,
  );
  value['linkedSources'][0]['media'] = media;
  media['processingStatus'] = 'ready';
  media['output'] = {...output, 'outputSha256': await meetingSha(output)};
  return value;
}

void main() {
  late _Api api;
  late MeetingsAccess access;
  late ApiMeetingsRepository repository;
  var current = true;
  setUp(() {
    api = _Api();
    access = MeetingsAccess(
      owner: meetingOwner,
      ready: true,
      commitmentsAvailable: true,
      operations: meetingWriteOperations.values.toSet(),
    );
    current = true;
    repository = ApiMeetingsRepository(
      api,
      access: access,
      authorityProbe: () => current,
    );
  });
  tearDown(() {
    repository.dispose();
    access.dispose();
  });
  test(
    'uses bounded fresh reads, exact encoded target and optional workspace',
    () async {
      api.reader = (_) => sealMeetingRead({
        'context': meetingContextJson(),
        'meetings': [meetingJson()],
      }, 'app.meetings.list');
      expect(
        (await repository.listSnapshot(CancelToken())).meetings,
        hasLength(1),
      );
      expect(api.query, {'limit': 100});
      api.reader = (_) =>
          sealMeetingRead(meetingDetailJson(), 'app.meetings.show');
      await repository.detailSnapshot(
        meetingTestId,
        CancelToken(),
        workspaceId: 'workspace:native',
      );
      expect(api.path, NativePaths.meetingsGet(meetingTestId));
      expect(api.query, {'workspaceId': 'workspace:native'});
    },
  );
  test('rejects wrong target, altered immutable digest and wrong operation receipt', () async {
    api.reader = (_) => sealMeetingRead(
      meetingDetailJson(id: meetingOtherId),
      'app.meetings.show',
    );
    await expectLater(
      repository.detailSnapshot(meetingTestId, CancelToken()),
      throwsFormatException,
    );
    api.reader = (_) =>
        sealMeetingRead(meetingDetailJson(), 'app.meetings.list');
    await expectLater(
      repository.detailSnapshot(meetingTestId, CancelToken()),
      throwsFormatException,
    );
    api.reader = (_) async {
      final value = await sealMeetingRead(
        meetingDetailJson(),
        'app.meetings.show',
      );
      value['meeting']['summary'] = 'Altered';
      return value;
    };
    await expectLater(
      repository.detailSnapshot(meetingTestId, CancelToken()),
      throwsFormatException,
    );
  });
  test('media content must match its own digest even with a valid current response receipt', () async {
    final value = await _detailWithMediaOutput();
    api.reader = (_) => sealMeetingRead(value, 'app.meetings.show');
    final valid = await repository.detailSnapshot(meetingTestId, CancelToken());
    expect(
      valid.sources.single.media!.output!.summary['text'],
      'Review the release.',
    );
    value['linkedSources'][0]['media']['output']['summary']['text'] =
        'A different unsupported claim.';
    // Re-sign only the response envelope; the immutable media digest still
    // identifies the earlier output and must independently fail validation.
    api.reader = (_) => sealMeetingRead(value, 'app.meetings.show');
    await expectLater(
      repository.detailSnapshot(meetingTestId, CancelToken()),
      throwsFormatException,
    );
  });
  test(
    'held read is canceled and fenced across same owner lock/unlock generation',
    () async {
      final held = Completer<Json>();
      api.reader = (_) => held.future;
      final request = repository.detailSnapshot(meetingTestId, CancelToken());
      final rejected = expectLater(request, throwsA(anything));
      access.update(meetingOwner, available: false);
      access.update(meetingOwner, available: true);
      expect(api.token!.isCancelled, isTrue);
      held.complete(
        await sealMeetingRead(meetingDetailJson(), 'app.meetings.show'),
      );
      await rejected;
    },
  );
  test('write transport binds exact owner/API/role, payload/key and excludes overlap', () async {
    final response = Completer<Json>();
    api.writer = () => response.future;
    final submitted = createSubmission(),
        first = repository.mutate(createSubmission());
    await expectLater(repository.mutate(submitted), throwsStateError);
    expect(api.authority!.canonicalUserId, meetingUserId);
    expect(api.authority!.tenantId, meetingOwner.tenantId);
    expect(api.headers!.keys.toList(), ['Idempotency-Key']);
    current = false;
    expect(
      () => api.authority!.requireCurrent(meetingOwner.apiScope),
      throwsA(anything),
    );
    response.complete({});
    await expectLater(first, throwsStateError);
  });
}
