import 'package:flutter_test/flutter_test.dart';
import 'package:asael/features/results/results.dart';

void main() {
  test('agent result exposes grounding evidence and cancel state', () {
    final result = ResultItem.agent({
      'id': 'run-1',
      'prompt': 'Research the market',
      'status': 'running',
      'response': 'Working',
      'grounding': {
        'status': 'verified',
        'citations': [
          {'url': 'https://example.test/source'},
        ],
      },
    });
    expect(result.key, 'agent:run-1');
    expect(result.canCancel, isTrue);
    expect(result.verified, isTrue);
    expect(result.evidence, ['https://example.test/source']);
    expect(result.tone, ResultTone.warning);
  });

  test('workflow result reads nested report and verification', () {
    final result = ResultItem.workflow({
      'id': 'w1',
      'goal': 'Deploy',
      'status': 'completed',
      'result': {
        'report': 'Deployment complete',
        'verification': {'status': 'verified'},
        'evidenceRefs': ['deploy:42'],
      },
    });
    expect(result.body, 'Deployment complete');
    expect(result.tone, ResultTone.success);
    expect(result.verified, isTrue);
  });

  test('strictly parses actor-safe generated artifact metadata', () {
    final artifact = GeneratedArtifactSummary.tryParse({
      'id': 'generated_artifact_${List.filled(48, 'a').join()}',
      'kind': 'presentation',
      'title': 'Service Cloud AI pitch',
      'filename': 'Service Cloud AI pitch.pptx',
      'currentVersion': 3,
      'createdAt': '2026-09-19T02:00:00.000Z',
      // Artifact-head updates and renderer lifecycle updates are independent.
      'updatedAt': '2026-09-19T02:00:00.000Z',
      'current': {
        'version': 3,
        'status': 'ready',
        'mediaType': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'byteCount': 4096,
        'queuedAt': '2026-09-19T02:00:00.000Z',
        'readyAt': '2026-09-19T02:01:00.000Z',
        'failedAt': null,
        'contentUrl': 'https://untrusted.example/private.pptx',
      },
    });

    expect(artifact, isNotNull);
    expect(artifact?.kind, GeneratedArtifactKind.presentation);
    expect(artifact?.status, GeneratedArtifactStatus.ready);
    expect(artifact?.version, 3);
    expect(artifact?.byteCount, 4096);
    expect(artifact?.ready, isTrue);
  });

  test('keeps valid pending files and rejects malformed file authority', () {
    final queued = _artifact({
      'current': {
        'version': 1,
        'status': 'queued',
        'mediaType': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'byteCount': null,
        'queuedAt': '2026-09-19T02:00:00.000Z',
        'readyAt': null,
        'failedAt': null,
      },
    });
    expect(
      GeneratedArtifactSummary.tryParse(queued)?.status,
      GeneratedArtifactStatus.queued,
    );
    expect(
      GeneratedArtifactSummary.tryParse(_artifact({'id': '../cross-actor'})),
      isNull,
    );
    expect(
      GeneratedArtifactSummary.tryParse(
        _artifact({
          'current': {
            'version': 1,
            'status': 'ready',
            'mediaType': 'application/pdf',
            'byteCount': 20,
            'queuedAt': '2026-09-19T02:00:00.000Z',
            'readyAt': '2026-09-19T02:01:00.000Z',
            'failedAt': null,
          },
        }),
      ),
      isNull,
    );
    expect(
      GeneratedArtifactSummary.tryParse(
        _artifact({
          'current': {
            'version': 1,
            'status': 'rendering',
            'mediaType': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            'byteCount': -5,
            'queuedAt': '2026-09-19T02:00:00.000Z',
            'readyAt': null,
            'failedAt': null,
          },
        }),
      ),
      isNull,
    );
  });
}

Map<String, dynamic> _artifact([Map<String, dynamic> overrides = const {}]) {
  final base = <String, dynamic>{
    'id': 'generated_artifact_${List.filled(48, 'b').join()}',
    'kind': 'presentation',
    'title': 'Quarterly review',
    'filename': 'Quarterly review.pptx',
    'currentVersion': 1,
    'createdAt': '2026-09-19T02:00:00.000Z',
    'updatedAt': '2026-09-19T02:01:00.000Z',
    'current': {
      'version': 1,
      'status': 'ready',
      'mediaType': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'byteCount': 20,
      'queuedAt': '2026-09-19T02:00:00.000Z',
      'readyAt': '2026-09-19T02:01:00.000Z',
      'failedAt': null,
    },
  };
  return {...base, ...overrides};
}
