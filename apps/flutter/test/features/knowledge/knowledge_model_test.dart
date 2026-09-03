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
}
