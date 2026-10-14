import 'package:asael/features/projects/project_commitment_fields.dart';
import 'package:asael/features/projects/projects.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'projects_fixture.dart';

void main() {
  testWidgets(
    'a human can set a civil date and named dependency without changing task prose or status',
    (tester) async {
      final task = ProjectTask.fromJson(taskJson());
      final draft = ProjectCommitmentDraft(task: task);
      final key = GlobalKey<FormState>();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SingleChildScrollView(
              child: Form(
                key: key,
                child: ProjectCommitmentFields(
                  draft: draft,
                  taskId: task.id,
                  tasks: [
                    task,
                    ProjectTask.fromJson({
                      ...taskJson(id: 'task:sandbox'),
                      'title': 'Sandbox ready',
                    }),
                  ],
                ),
              ),
            ),
          ),
        ),
      );
      await tester.enterText(
        find.byKey(const Key('project-human-owner')),
        'Elena Ruiz',
      );
      await tester.tap(find.byKey(const Key('project-deadline-kind')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Calendar date — no time').last);
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const Key('project-due-date')),
        '2026-02-30',
      );
      expect(key.currentState!.validate(), isFalse);
      await tester.enterText(
        find.byKey(const Key('project-due-date')),
        '2026-10-16',
      );
      await tester.ensureVisible(find.text('Sandbox ready'));
      await tester.tap(find.text('Sandbox ready'));
      expect(key.currentState!.validate(), isTrue);
      expect(draft.changes, {
        'humanOwner': 'Elena Ruiz',
        'dueDate': '2026-10-16',
        'dueTimeZone': null,
        'dueAt': null,
        'dependsOn': ['task:sandbox'],
      });
      expect(draft.changes.containsKey('detail'), isFalse);
      expect(draft.changes.containsKey('status'), isFalse);
      expect(find.text(task.title), findsNothing);
    },
  );

  test('editing an existing timed deadline preserves it unless explicitly replaced', () {
    final draft = ProjectCommitmentDraft(
      task: ProjectTask.fromJson({
        ...taskJson(),
        'dueAt': '2026-10-16T10:00:00+05:30',
      }),
    );
    expect(draft.deadline, 'existing');
    expect(draft.changes.containsKey('dueAt'), isFalse);
    draft.deadline = 'date';
    draft.dueDate = '2026-10-17';
    expect(draft.changes['dueAt'], isNull);
    expect(draft.changes['dueDate'], '2026-10-17');
  });
}
