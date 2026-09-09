import 'package:flutter_test/flutter_test.dart';
import 'package:asael/features/knowledge/knowledge.dart';

void main() {
  test('memory preserves provenance and correction links', () {
    final memory = MemoryRecord.fromJson({
      'id': 'm2',
      'title': 'Corrected',
      'content': 'New fact',
      'type': 'fact',
      'source': 'manual',
      'claimStatus': 'active',
      'assertedBy': 'user',
      'confidence': .95,
      'evidenceRefs': ['doc:1'],
      'supersedesId': 'm1',
    });
    expect(memory.evidenceRefs, ['doc:1']);
    expect(memory.supersedesId, 'm1');
    expect(memory.confidence, .95);
  });

  test('graph node parses inspector metadata', () {
    final node = GraphNode.fromJson({
      'id': 'n',
      'label': 'Flutter',
      'kind': 'concept',
      'weight': .8,
      'sourceCount': 3,
      'tags': ['mobile'],
    });
    expect(node.label, 'Flutter');
    expect(node.sourceCount, 3);
  });

  test('memory intelligence items retain categories without exact content', () {
    final memory = MemoryRecord.fromJson({
      'id': 'memory-indexed',
      'title': 'Preferred meeting time',
      'category': 'preferences',
      'tier': 'preference',
      'state': 'active',
      'evidenceCount': 2,
    });
    expect(memory.category, 'preferences');
    expect(memory.tier, 'preference');
    expect(memory.evidenceCount, 2);
    expect(memory.content, isEmpty);
  });

  test('forget preview parses governed deletion impact', () {
    final preview = MemoryForgetPreview.fromJson({
      'expectedReceiptManifestSha256':
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'guarantee': 'rollback_proof_barrier',
      'impact': {
        'descendantMemoryCount': 2,
        'graphNodeCount': 7,
        'graphEdgeCount': 8,
        'retrievalTraceCount': 3,
      },
    });
    expect(preview.descendantMemoryCount, 2);
    expect(preview.graphEdgeCount, 8);
    expect(preview.expectedReceiptManifestSha256, hasLength(64));
  });
}
